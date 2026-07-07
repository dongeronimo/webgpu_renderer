# HOW TO MODIFY THE UI

Our UI uses Redux, in the older, pre-covid style i'm used to. The UI framework is React,also in the older pre-covid style i'm used to (fully functional but without the newer things).

We have Actions, Reducers and States. Actions are dispatched to reducers, the reducers change the state, the react components that are listening to the state updates and the Behaviours get the updated values when they run every frame.

--- 

# Generic Components
TODO

--- 

# Creating a new field

1) Create the action
  - Create the Name
  - Create the interface
  - Create the function
  - Add the action to the Union.

2) Modify the state
  - Add the field to the state that should hold it
  - Update the state's initial value

3) Modify the reducer
  - add the case to the switch statement
  - modify the state with the new value
  - return the state

4) Add and use Dispatch
  - add ``` const dispatch = useDispatch<AppDispatch>();```
  - in the appropriate callbacks dispatch like this: ```dispatch(setAlphaScale(value)```

5) Listen to field change with ```useSelector```
